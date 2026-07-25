%@ WebService Language="C#" Class="BABYLONJS.licenser" %>
using System;
using System.IO;
using System.Net;
using System.Web;
using System.Text;
using System.Linq;
using System.Threading;
using System.Security;
using System.Configuration;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Security.Principal;

using System.Web.Script.Serialization;
using System.Web.Script.Services;
using System.Web.Services;

using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace BABYLONJS
{
    public class Toolkit
    {
        public static readonly log4net.ILog LicenseLogger = log4net.LogManager.GetLogger(System.Reflection.MethodBase.GetCurrentMethod().DeclaringType);

		public static string PaypalEndpoint = "https://api.paypal.com/v1/billing/subscriptions";
		public static string PaypalClientID = "wtf";
		public static string PaypalSecretKey = "wtf";

        public const string IndieDeveloperPlan = "wtf-id";
        public const string SmallBusinessPlan  = "wtf-id";
        public const string PremiumContentPlan = "wtf-id";
    }

    [Serializable] public enum Plan { Indie = 0, SmallBusiness = 1, PremiumContent = 2, EnterprisePartner = 3 }

    [Serializable] public class License { public string licensee; public string product; public string project; public string secret; public bool trial; public string plan; public string org; public string key; public string s1; public string s2; public string expires; }

    [Serializable] public class Subscription { public string id; public string plan; public string start; public string email; public string status; }

    public class Utilities
    {
        public static Subscription QuerySubscriptionInfo(string id)
        {
            Subscription result = null;
            string json = Utilities.QueryPayPalSubscriptionJson(id);
            if (!String.IsNullOrWhiteSpace(json) && json.StartsWith("{"))
            {
                JObject data = JObject.Parse(json);
                if (data != null)
                {
                    result = new Subscription();
                    // SUBSCRIPTION STATUS
                    // ..
                    // APPROVAL_PENDING. The subscription is created but not yet approved by the buyer.
                    // APPROVED. The buyer has approved the subscription.
                    // ACTIVE. The subscription is active.
                    // SUSPENDED. The subscription is suspended.
                    // CANCELLED. The subscription is cancelled.
                    // EXPIRED. The subscription is expired.
                    // ..
					var data_id = data.SelectToken("id");
                    if (data_id != null)
                    {
                        result.id = data_id.Value<string>();
                    }
					var data_plan = data.SelectToken("plan_id");
                    if (data_plan != null)
                    {
                        result.plan = data_plan.Value<string>();
                    }
					var data_start = data.SelectToken("start_time");
                    if (data_start != null)
                    {
                        result.start = data_start.Value<string>();
                    }
					var data_email = data.SelectToken("$.subscriber.email_address");
                    if (data_email != null)
                    {
                        result.email = data_email.Value<string>();
                    }
					var data_status = data.SelectToken("status");
                    if (data_status != null)
                    {
                        result.status = data_status.Value<string>();
                    }
                }
            }
            return result;
        }

        public static string QueryPayPalSubscriptionJson(string id)
        {
            string result = null;
            string endpoint = Toolkit.PaypalEndpoint;
            string clientid = Toolkit.PaypalClientID;
            string secretkey = Toolkit.PaypalSecretKey;
            if (!String.IsNullOrWhiteSpace(endpoint) && !String.IsNullOrWhiteSpace(clientid) && !String.IsNullOrWhiteSpace(secretkey))
            {
                string paypalapi = (endpoint.Trim().TrimEnd('/') + "/" + id);
                string credentials = Convert.ToBase64String(Encoding.UTF8.GetBytes(clientid + ":" + secretkey));
                ServicePointManager.Expect100Continue = true;
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
                // Note: Requires Windows Security Permissions: ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
                using (WebClient client = new WebClient())
                {
                    client.Headers[HttpRequestHeader.Authorization] = String.Format("Basic {0}", credentials);
                    client.Headers[HttpRequestHeader.ContentType] = "application/json";
                    try
                    {
                        result = client.DownloadString(paypalapi);
                    }
                    catch (Exception ex)
                    {
                        result = ex.Message;
                    }
                }
            }
            return result;
        }

        public static string ComputeProjectLicenseKeyHash(string seed)
        {
            string privatekey1 = "babylontoolkit.com";
            string privatekey2 = "05.00.00";
            string productIdentifier = (seed.Replace(" ", "_") + "-" + privatekey1.Replace(" ", "_") + "-" + privatekey2.Replace(" ", "_")).ToLower();
            // ..
            // Compute Hash
            // ..
            System.Text.Encoder enc = System.Text.Encoding.Unicode.GetEncoder();
            byte[] unicodeText = new byte[productIdentifier.Length * 2];
            enc.GetBytes(productIdentifier.ToCharArray(), 0, productIdentifier.Length, unicodeText, 0, true);
            MD5 md5 = new MD5CryptoServiceProvider();
            byte[] result = md5.ComputeHash(unicodeText);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < result.Length; i++)
            {
                sb.Append(result[i].ToString("X2"));
            }
            // ..
            // Format License Key
            // ..
            string productIdentifierHash = sb.ToString().Substring(0, 28).ToUpper();
            char[] serialArray = productIdentifierHash.ToCharArray();
            StringBuilder licenseKey = new StringBuilder();
            int j = 0;
            for (int i = 0; i < 28; i++)
            {
                for (j = i; j < 4 + i; j++)
                {
                    licenseKey.Append(serialArray[j]);
                }
                if (j == 28)
                {
                    break;
                }
                else
                {
                    i = (j) - 1;
                    licenseKey.Append("-");
                }
            }
            return licenseKey.ToString();
        }
    }

    /// <summary>
    /// Summary description for licenser
    /// </summary>
    [WebService(Namespace = "http://tempuri.org/")]
    [WebServiceBinding(ConformsTo = WsiProfiles.BasicProfile1_1)]
    [System.ComponentModel.ToolboxItem(false)]
    // To allow this Web Service to be called from script, using ASP.NET AJAX, uncomment the following line. 
    // [System.Web.Script.Services.ScriptService]
    public class licenser : System.Web.Services.WebService
    {
        [WebMethod]
        [ScriptMethod(ResponseFormat = ResponseFormat.Json)]
        public void GeneratePartnerLicense(string secret, string company, string organization, int days = 0)
        {
            if (secret != ConfigurationManager.AppSettings["ADMIN_API_KEY"]) throw new HttpException(500, "Invalid web service secret key");
            string product = "*";
            string project = "*";
            string expires = (days > 0) ? DateTime.Now.AddDays(days).ToShortDateString() : "never";
            // ..
            // Generate Partner License Key
            // ..
            Plan plan = Plan.EnterprisePartner;
            string remote = Context.Request.UserHostAddress;
            string content = String.Format("{0}|{1}|{2}|{3}|{4}|{5}", plan.ToString(), company, organization, product, project, expires);
            License license = new License();
            license.licensee = company;
            license.product = product;
            license.project = project;
            license.secret = SecurityTools.EncryptString(content);
            license.trial = false;
            license.plan = plan.ToString();
            license.org = organization;
            license.key = Utilities.ComputeProjectLicenseKeyHash((license.plan + "-" + company));
            license.s1 = "unlimited";
            license.s2 = "unlimited";
            license.expires = expires;
            Context.Response.ContentType = "application/json";
            Context.Response.Write(Newtonsoft.Json.JsonConvert.SerializeObject(license, Newtonsoft.Json.Formatting.Indented));
            Toolkit.LicenseLogger.InfoFormat("{0} - Generated partner license: {1} - {2}", remote, company, organization);
        }

        [WebMethod]
        [ScriptMethod(ResponseFormat = ResponseFormat.Json)]
        public void GenerateProjectLicense(string secret, string licensee, string devid, string email, string product, string project, string organization)
        {
            if (secret != ConfigurationManager.AppSettings["ADMIN_API_KEY"]) throw new HttpException(500, "Invalid web service secret key");
            Subscription subscription = Utilities.QuerySubscriptionInfo(devid);
            if (subscription != null && subscription.id.Equals(devid, StringComparison.OrdinalIgnoreCase))
            {
                if (subscription.email.Equals(email, StringComparison.OrdinalIgnoreCase))
                {
                    // ..
                    // Validate Plan Type
                    // ..
                    Plan plan = Plan.Indie;
                    string seats = "locked";
                    if (subscription.plan == Toolkit.PremiumContentPlan)
                    {
                        plan = Plan.PremiumContent;
                        seats = "unlocked";
                    }
                    else if (subscription.plan == Toolkit.SmallBusinessPlan)
                    {
                        plan = Plan.SmallBusiness;
                        seats = "unlocked";
                    }
                    // ..
                    // Validate Status
                    // ..
                    bool trial = true;
                    bool active = false;
                    string expires = DateTime.Now.AddDays(31).ToShortDateString();
                    if (subscription.status == "ACTIVE")                // Fully Active
                    {
                        trial = false;
                        active = true;
                        expires = "never";
                    }
                    else if (subscription.status == "APPROVED")         // Trial Licenese
                    {
                        trial = true;
                        active = true;
                        expires = DateTime.Parse(subscription.start).AddDays(31).ToShortDateString();
                    }
                    else if (subscription.id == "I-J7PGUH6N8FAB")       // Demo User Account
                    {
                        // Test Demo
                    	plan = Plan.PremiumContent;
                    	// plan = Plan.SmallBusiness;
                    	// plan = Plan.Indie;
                        seats = "unlocked";
                        trial = false;
                        active = true;
                        // expires = DateTime.Now.AddDays(31).ToShortDateString();
						// expires = "01-01-2020";
                        expires = "never";

                        // Active Demo
                        // trial = false;
                        // active = true;
                        // expires = "never";
                    }
                    // ..
                    // Generate Project License Key
                    // ..
                    if (active == true)
                    {
                        string remote = Context.Request.UserHostAddress;
                        string content = String.Format("{0}|{1}|{2}|{3}|{4}|{5}", plan.ToString(), licensee, organization, product, project, expires);
                        License license = new License();
                        license.licensee = licensee;
                        license.product = product;
                        license.project = project;
                        license.secret = SecurityTools.EncryptString(content);
                        license.trial = trial;
                        license.plan = plan.ToString();
                        license.org = organization;
                        license.key = Utilities.ComputeProjectLicenseKeyHash((license.plan + "-" + product));
                        license.s1 = seats;
                        license.s2 = seats;
            		license.expires = expires;
                        Context.Response.ContentType = "application/json";
                        Context.Response.Write(Newtonsoft.Json.JsonConvert.SerializeObject(license, Newtonsoft.Json.Formatting.Indented));
                        Toolkit.LicenseLogger.InfoFormat("{0} - Generated project license: {1} - {2} - {3}", remote, licensee, organization, project);
                    }
                    else
                    {
                        throw new HttpException(500, "Subscription Not Active");
                    }
                }
                else
                {
                    throw new HttpException(500, "Invalid Subscriber Email");
                }
            }
            else
            {
                throw new HttpException(500, "Subscription Not Found");
            }
        }
    }

    public class SecurityTools
    {
        // This constant is used to determine the keysize of the encryption algorithm
        private static int GetKeySize() { return 256; }
        // This constant is used to determine the keysize of the encryption algorithm
        // [DllImport("YourDLL")] private static extern string Internal_GetKeyPhrase();
        private static string GetKeyPhrase() { return "12bucklemyshoe" /*UnityTools.Internal_GetKeyPhrase()*/; }
        // This size of the IV (in bytes) must = (keysize / 8).  Default keysize is 256, so the IV must be
        // 32 bytes long.  Using a 16 character string here gives us 32 bytes when converted to a byte array.
        // [DllImport("YourDLL")] private static extern string Internal_GetInitVector();
        private static string GetInitVector() { return "xdgrq4yhjmd1ajel" /*UnityTools.Internal_GetInitVector()*/; }
        /* YourDLL - TODO: Get Internal Key Phrase From Native Code Native Code
        extern "C" {
            LPTRSTR Internal_GetKeyPhrase() { return "12bucklemyshoe"; }
            LPTRSTR Internal_GetInitVector() { return "xdgrq4yhjmd1ajel"; }
        }*/

        public static void AuthenticateUser(string credentials)
        {
            try
            {
                var encoding = Encoding.GetEncoding("iso-8859-1");
                credentials = encoding.GetString(Convert.FromBase64String(credentials));

                int separator = credentials.IndexOf(':');
                string name = credentials.Substring(0, separator);
                string password = credentials.Substring(separator + 1);

                if (SecurityTools.CheckUserPassword(name, password))
                {
                    var identity = new GenericIdentity(name);
                    SecurityTools.SetPrincipal(new GenericPrincipal(identity, null));
                }
                else
                {
                    // Invalid username or password.
                    SecurityTools.RejectAuthenticate();
                }
            }
            catch (FormatException)
            {
                // Credentials were not formatted correctly.
                SecurityTools.RejectAuthenticate();
            }
        }

        public static void AuthenticateAdmin(string credentials)
        {
            try
            {
                var encoding = Encoding.GetEncoding("iso-8859-1");
                credentials = encoding.GetString(Convert.FromBase64String(credentials));

                int separator = credentials.IndexOf(':');
                string name = credentials.Substring(0, separator);
                string password = credentials.Substring(separator + 1);

                if (SecurityTools.CheckAdminPassword(name, password))
                {
                    var identity = new GenericIdentity(name);
                    SecurityTools.SetPrincipal(new GenericPrincipal(identity, null));
                }
                else
                {
                    // Invalid username or password.
                    SecurityTools.RejectAuthenticate();
                }
            }
            catch (FormatException)
            {
                // Credentials were not formatted correctly.
                SecurityTools.RejectAuthenticate();
            }
        }

        public static void RejectAuthenticate()
        {
            HttpContext.Current.Response.StatusCode = 401;
        }

        public static string EncryptString(string plainText)
        {
            string passPhrase = SecurityTools.GetKeyPhrase();
            byte[] initVectorBytes = Encoding.UTF8.GetBytes(SecurityTools.GetInitVector());
            byte[] plainTextBytes = Encoding.UTF8.GetBytes(plainText);
            PasswordDeriveBytes password = new PasswordDeriveBytes(passPhrase, null);
            byte[] keyBytes = password.GetBytes(SecurityTools.GetKeySize() / 8);
            RijndaelManaged symmetricKey = new RijndaelManaged();
            symmetricKey.Mode = CipherMode.CBC;
            ICryptoTransform encryptor = symmetricKey.CreateEncryptor(keyBytes, initVectorBytes);
            MemoryStream memoryStream = new MemoryStream();
            CryptoStream cryptoStream = new CryptoStream(memoryStream, encryptor, CryptoStreamMode.Write);
            cryptoStream.Write(plainTextBytes, 0, plainTextBytes.Length);
            cryptoStream.FlushFinalBlock();
            byte[] cipherTextBytes = memoryStream.ToArray();
            memoryStream.Close();
            cryptoStream.Close();
            return Convert.ToBase64String(cipherTextBytes);
        }

        public static string DecryptString(string cipherText)
        {
            string passPhrase = SecurityTools.GetKeyPhrase();
            byte[] initVectorBytes = Encoding.UTF8.GetBytes(SecurityTools.GetInitVector());
            byte[] cipherTextBytes = Convert.FromBase64String(cipherText);
            PasswordDeriveBytes password = new PasswordDeriveBytes(passPhrase, null);
            byte[] keyBytes = password.GetBytes(SecurityTools.GetKeySize() / 8);
            RijndaelManaged symmetricKey = new RijndaelManaged();
            symmetricKey.Mode = CipherMode.CBC;
            ICryptoTransform decryptor = symmetricKey.CreateDecryptor(keyBytes, initVectorBytes);
            MemoryStream memoryStream = new MemoryStream(cipherTextBytes);
            CryptoStream cryptoStream = new CryptoStream(memoryStream, decryptor, CryptoStreamMode.Read);
            byte[] plainTextBytes = new byte[cipherTextBytes.Length];
            int decryptedByteCount = cryptoStream.Read(plainTextBytes, 0, plainTextBytes.Length);
            memoryStream.Close();
            cryptoStream.Close();
            return Encoding.UTF8.GetString(plainTextBytes, 0, decryptedByteCount);
        }

        private static bool CheckUserPassword(string username, string password)
        {
            return (username == "user" && password == ConfigurationManager.AppSettings["UserPassword"]);
        }

        private static bool CheckAdminPassword(string username, string password)
        {
            return (username == "admin" && password == ConfigurationManager.AppSettings["AdminPassword"]);
        }

        private static void SetPrincipal(IPrincipal principal)
        {
            Thread.CurrentPrincipal = principal;
            if (HttpContext.Current != null)
            {
                HttpContext.Current.User = principal;
            }
        }
    }
}
